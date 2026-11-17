/** Exact marker interpreted by the existing durable run task, not a user-programmable controller. */
export const SDLC_SCRIPT = `export const meta = {
  name: 'sdlc',
  description: 'Implement and independently validate a durable goal with adaptive tasks'
}
throw new Error('The sdlc built-in requires WorkflowHost and its durable controller')
`;
