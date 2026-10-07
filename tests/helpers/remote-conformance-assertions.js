/** Native-safe assertions for Pi's runner-independent environment conformance cases. */
function fail(message) { throw new Error(`Pi environment conformance: ${message}`); }
function equal(actual, expected, partial = false) {
  if (Object.is(actual, expected)) return true;
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') return false;
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  if (!partial && actualKeys.length !== expectedKeys.length) return false;
  return expectedKeys.every((key) => Object.hasOwn(actual, key) && equal(actual[key], expected[key], partial));
}
export const remoteConformanceAssertions = {
  ok(value, message) { if (!value) fail(message ?? 'expected a truthy value'); },
  strictEqual(actual, expected) { if (!Object.is(actual, expected)) fail(`expected ${String(expected)}, received ${String(actual)}`); },
  deepEqual(actual, expected) { if (!equal(actual, expected)) fail('deep equality failed'); },
  partialDeepEqual(actual, expected) { if (!equal(actual, expected, true)) fail('partial deep equality failed'); },
  greaterThan(actual, expected) { if (!(actual > expected)) fail(`expected ${actual} > ${expected}`); },
  async rejects(operation, messageIncludes) {
    try { await operation(); }
    catch (error) {
      if (!String(error?.message).includes(messageIncludes)) fail(`rejection did not include ${messageIncludes}`);
      return;
    }
    fail('expected rejection');
  },
};
