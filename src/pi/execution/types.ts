import type { Context } from '@earendil-works/chord';
import type { PromptInput } from '@earendil-works/pi-durable';

/** What the selected environment tells the model about itself; local and remote compositions each supply it. */
export interface SharedToolPolicy {
  promptFacts(input: PromptInput, context: Context): readonly string[] | Promise<readonly string[]>;
}
