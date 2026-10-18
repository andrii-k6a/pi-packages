#!/usr/bin/env bash
# Third-party skills. Installs globally into ~/.agents/skills.
set -e
npx --yes skills add vercel-labs/skills -s find-skills -a pi -g -y
npx --yes skills add vercel-labs/agent-browser -s agent-browser -a pi -g -y
npx --yes skills add danyuchn/asd-ste100-skill -s asd-ste100 -a pi -g -y
npx --yes skills add anthropics/skills -s pdf -a pi -g -y
