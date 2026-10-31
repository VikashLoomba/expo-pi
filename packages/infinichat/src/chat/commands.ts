/**
 * A command the user types in InfiniChat's message field as `/name`, which the app runs itself instead of sending it to
 * the agent, as agent apps take slash commands: typing `/` lists them, and the list narrows as the name is typed.
 */
export interface ChatCommand {
  name: string;
  description: string;
}

/** InfiniChat's commands, in the order the list shows them. */
export const INFINICHAT_COMMANDS: readonly ChatCommand[] = [
  {
    name: 'reload-plugins',
    description: 'Reload plugins and MCP configuration on the machine InfiniChat runs on.',
  },
];

const PARTIAL = /^\/([a-z-]*)$/;
const WHOLE = /^\/([a-z-]+)$/;

/** The commands a draft that is only `/` and part of a name could complete to; none once it is anything more. */
export function commandSuggestions(draft: string, commands: readonly ChatCommand[]): readonly ChatCommand[] {
  const typed = PARTIAL.exec(draft)?.[1];
  return typed === undefined ? [] : commands.filter((command) => command.name.startsWith(typed));
}

/** The command a draft names whole, `/name` and nothing else, which sending runs instead of sending it. */
export function draftCommand(draft: string, commands: readonly ChatCommand[]): ChatCommand | undefined {
  const name = WHOLE.exec(draft.trim())?.[1];
  return commands.find((command) => command.name === name);
}
