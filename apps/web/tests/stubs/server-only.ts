/**
 * Test stub for the `server-only` marker package.
 *
 * The real package throws under vitest's default export condition, which would
 * make any module carrying the marker untestable. Aliasing it here keeps the
 * marker meaningful for the Next.js build — where it is what prevents secret
 * handling from reaching a browser bundle — while letting the pure logic inside
 * those modules be tested.
 */
export {};
