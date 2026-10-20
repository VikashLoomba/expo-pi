/**
 * UniiChat's agent names (Names.ts, VictorTaelin/UniiChat 0500bf6, Apache-2.0): a common adjective and noun,
 * capitalized and joined, as FireAnt; one taken is drawn again.
 */
const ADJECTIVES = `
red blue green yellow orange purple pink brown black white gray silver golden amber azure bronze copper jade
lemon lime mint navy peach plum ruby violet cherry honey big small tiny huge giant little tall short long
round flat thick thin deep soft hard smooth rough fuzzy fluffy shiny crunchy crispy leafy spiky hot cold warm
cool icy frosty snowy rainy sunny cloudy windy stormy foggy misty sweet sour salty spicy juicy minty nutty
creamy smoky tasty fresh bright dark quiet loud happy jolly merry calm brave bold clever wise kind gentle
lucky proud quick swift fast slow eager busy sleepy silly funny shy neat noble grand royal mighty strong
steady nimble lively cozy old new young ancient wooden stone paper iron magic cosmic lunar solar polar wild
`
  .split(/\s+/)
  .filter(Boolean);

const NOUNS = `
ant bat bear bee beetle bird bison camel cat cheetah chicken clam cobra cougar cow crab crane crow deer dog
dolphin donkey dove dragon duck eagle eel elk falcon finch fish flamingo fox frog gazelle gecko giraffe goat
goose gorilla hamster hare hawk hedgehog heron hippo horse hyena iguana jaguar jay kangaroo kitten koala lamb
lemur leopard lion lizard llama lobster moose moth mouse mule octopus orca otter owl ox oyster panda parrot
pelican penguin pig pigeon pony puffin puma rabbit raccoon raven rhino robin salmon seal shark sheep shrimp
skunk sloth snail snake sparrow spider squid squirrel swan tiger toad toucan trout tuna turkey turtle walrus
wasp whale wolf wombat yak zebra apple banana bagel cookie mango melon muffin noodle pancake pepper potato
pretzel radish taco waffle
`
  .split(/\s+/)
  .filter(Boolean);

const capitalized = (word: string): string =>
  word[0].toUpperCase() + word.slice(1);
const pick = (words: string[]): string =>
  capitalized(words[Math.floor(Math.random() * words.length)]);

/** A name no agent has, drawn as UniiChat draws one. */
export function agentName(taken: readonly string[]): string {
  for (;;) {
    const name = pick(ADJECTIVES) + pick(NOUNS);
    if (!taken.includes(name)) return name;
  }
}
