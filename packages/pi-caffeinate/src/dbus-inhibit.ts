import { type Message, type MessageBus, sessionBus } from 'dbus-native';

export const SCREEN_SAVER_SERVICE = 'org.freedesktop.ScreenSaver';
export const SCREEN_SAVER_INTERFACE = 'org.freedesktop.ScreenSaver';
export const SCREEN_SAVER_REASON = 'Pi agent is active';

const APPLICATION_NAME = 'pi-caffeinate';
const OBJECT_PATHS = ['/org/freedesktop/ScreenSaver', '/ScreenSaver'];
const CALL_TIMEOUT_MS = 2_000;
const NAME_OWNER_CHANGED_RULE =
  "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='org.freedesktop.ScreenSaver'";
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_INTERFACE = 'org.freedesktop.DBus';

type FailureHandler = (error: Error) => void;

type OwnerWatch = { remove(): Promise<void> };

export interface ScreenSaverClient {
  setFailureHandler(handler: FailureHandler | undefined): void;
  inhibit(reason: string, signal?: AbortSignal): Promise<void>;
  uninhibit(): Promise<void>;
  close(): Promise<void>;
}

export type ScreenSaverFactory = () => Promise<ScreenSaverClient>;

export async function createScreenSaverClient(): Promise<ScreenSaverClient> {
  return new NativeScreenSaverClient(sessionBus());
}

class NativeScreenSaverClient implements ScreenSaverClient {
  #cookie: number | undefined;
  #objectPath: string | undefined;
  #failureHandler: FailureHandler | undefined;
  #pendingFailure: Error | undefined;
  #ownerWatch: OwnerWatch | undefined;
  #ownerWatchStart: Promise<void> | undefined;
  #ownerRevision = 0;
  #closed = false;

  readonly #onConnectionError = (error: unknown): void => this.#reportFailure(error);
  readonly #onConnectionClose = (error: unknown): void => {
    if (!this.#closed) this.#reportFailure(error ?? new Error('D-Bus session connection closed'));
  };
  readonly #onNameOwnerChanged = (body: unknown[]): void => {
    const [name, previousOwner, nextOwner] = body;
    if (
      name !== SCREEN_SAVER_SERVICE ||
      typeof previousOwner !== 'string' ||
      typeof nextOwner !== 'string' ||
      previousOwner === nextOwner
    ) {
      return;
    }
    this.#ownerRevision += 1;
    if (previousOwner.length > 0) {
      this.#reportFailure(new Error('D-Bus ScreenSaver service owner changed'));
    }
  };

  constructor(private readonly bus: MessageBus) {
    bus.connection.on('error', this.#onConnectionError);
    bus.connection.on('close', this.#onConnectionClose);
  }

  setFailureHandler(handler: FailureHandler | undefined): void {
    this.#failureHandler = handler;
    if (!handler || !this.#pendingFailure) return;
    const failure = this.#pendingFailure;
    this.#pendingFailure = undefined;
    handler(failure);
  }

  async inhibit(reason: string, signal?: AbortSignal): Promise<void> {
    await this.#watchServiceOwner();
    let lastError: unknown;
    for (const path of OBJECT_PATHS) {
      if (signal?.aborted) throw abortError(signal);
      if (this.#closed) throw new Error('D-Bus ScreenSaver client is closed');
      const ownerRevision = this.#ownerRevision;
      let cookie: number;
      try {
        cookie = await invoke<number>(
          this.bus,
          {
            destination: SCREEN_SAVER_SERVICE,
            path,
            interface: SCREEN_SAVER_INTERFACE,
            member: 'Inhibit',
            signature: 'ss',
            body: [APPLICATION_NAME, reason]
          },
          signal
        );
      } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        lastError = error;
        continue;
      }
      if (this.#closed) throw new Error('D-Bus ScreenSaver client is closed');
      if (ownerRevision !== this.#ownerRevision) {
        throw new Error('D-Bus ScreenSaver service owner changed while inhibiting');
      }
      this.#cookie = cookie;
      this.#objectPath = path;
      return;
    }
    throw new Error(`ScreenSaver D-Bus inhibition failed: ${errorMessage(lastError)}`);
  }

  async uninhibit(): Promise<void> {
    if (this.#cookie === undefined || !this.#objectPath) return;
    const cookie = this.#cookie;
    const path = this.#objectPath;
    this.#cookie = undefined;
    this.#objectPath = undefined;
    await invoke<void>(this.bus, {
      destination: SCREEN_SAVER_SERVICE,
      path,
      interface: SCREEN_SAVER_INTERFACE,
      member: 'UnInhibit',
      signature: 'u',
      body: [cookie]
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#cookie = undefined;
    this.#objectPath = undefined;
    this.#failureHandler = undefined;
    this.bus.signals?.off(
      this.bus.mangle(DBUS_PATH, DBUS_INTERFACE, 'NameOwnerChanged'),
      this.#onNameOwnerChanged
    );
    const ownerWatch = this.#ownerWatch;
    const ownerWatchStart = this.#ownerWatchStart;
    this.#ownerWatch = undefined;
    try {
      await ownerWatch?.remove().catch(() => undefined);
      await ownerWatchStart?.catch(() => undefined);
      await this.bus.close();
    } finally {
      // The connection can emit `error` while `bus.close()` is still awaiting
      // transport teardown. Keep this listener until that close window ends.
      this.bus.connection.off('error', this.#onConnectionError);
      this.bus.connection.off('close', this.#onConnectionClose);
    }
  }

  async #watchServiceOwner(): Promise<void> {
    if (this.#closed) throw new Error('D-Bus ScreenSaver client is closed');
    if (this.#ownerWatch) return;
    if (this.#ownerWatchStart) return this.#ownerWatchStart;
    if (!this.bus.signals || !this.bus.watch) {
      throw new Error('D-Bus NameOwnerChanged watch is unavailable');
    }

    const signal = this.bus.mangle(DBUS_PATH, DBUS_INTERFACE, 'NameOwnerChanged');
    this.bus.signals.on(signal, this.#onNameOwnerChanged);
    const starting = (async (): Promise<void> => {
      try {
        const ownerWatch = await this.bus.watch(NAME_OWNER_CHANGED_RULE);
        if (this.#closed) {
          await ownerWatch.remove().catch(() => undefined);
          return;
        }
        this.#ownerWatch = ownerWatch;
      } catch (error) {
        this.bus.signals.off(signal, this.#onNameOwnerChanged);
        throw error;
      } finally {
        this.#ownerWatchStart = undefined;
      }
    })();
    this.#ownerWatchStart = starting;
    return starting;
  }

  #reportFailure(error: unknown): void {
    if (this.#cookie === undefined) return;
    this.#cookie = undefined;
    this.#objectPath = undefined;
    const failure = asError(error, 'D-Bus session connection failed');
    if (this.#failureHandler) this.#failureHandler(failure);
    else this.#pendingFailure = failure;
  }
}

function invoke<T>(bus: MessageBus, message: Message, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    bus.invoke(message, { signal, timeout: CALL_TIMEOUT_MS }, (error, ...values) => {
      if (error) reject(error);
      else resolve(values[0] as T);
    });
  });
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('D-Bus inhibition cancelled', 'AbortError');
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
