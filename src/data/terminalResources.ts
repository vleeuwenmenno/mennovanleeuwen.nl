/** Read-only account resources exposed by msh. Grants are issued by the server, not tool arguments. */
export const TERMINAL_RESOURCES = [
  { id: 'notes', subcommand: 'notes', tool: 'search_notes' },
  { id: 'calendar', subcommand: 'calendar', tool: 'calendar_list_events' },
  // Task status is an authenticated account read, independent of task mutation permissions.
  { id: 'background-tasks', subcommand: 'tasks', tool: null },
] as const
export type TerminalResource = typeof TERMINAL_RESOURCES[number]['id']
