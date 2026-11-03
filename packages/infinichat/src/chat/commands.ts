/**
 * A command the user types in InfiniChat's message field as `/name`, which the app runs itself instead of sending it to
 * the agent, as agent apps take slash commands: typing `/` lists them, and the list narrows as the name is typed.
 */
export interface ChatCommand<Name extends string = string> {
  name: Name;
  description: string;
}

/** InfiniChat's commands, in the order the list shows them; each app runs every one (`InfiniChatCommandName`). */
export const INFINICHAT_COMMANDS = [
  {
    name: 'mcp',
    description: 'Show the MCP servers on the machine InfiniChat runs on, and sign in to them.',
  },
  {
    name: 'reload-plugins',
    description: 'Reload plugins and MCP configuration on the machine InfiniChat runs on.',
  },
] as const satisfies readonly ChatCommand[];
export type InfiniChatCommandName = (typeof INFINICHAT_COMMANDS)[number]['name'];
export type InfiniChatCommand = ChatCommand<InfiniChatCommandName>;

const PARTIAL = /^\/([a-z-]*)$/;
const WHOLE = /^\/([a-z-]+)$/;

/** The commands a draft that is only `/` and part of a name could complete to; none once it is anything more. */
export function commandSuggestions<C extends ChatCommand>(draft: string, commands: readonly C[]): readonly C[] {
  const typed = PARTIAL.exec(draft)?.[1];
  return typed === undefined ? [] : commands.filter((command) => command.name.startsWith(typed));
}

/** The command a draft names whole, `/name` and nothing else, which sending runs instead of sending it. */
export function draftCommand<C extends ChatCommand>(draft: string, commands: readonly C[]): C | undefined {
  const name = WHOLE.exec(draft.trim())?.[1];
  return commands.find((command) => command.name === name);
}
