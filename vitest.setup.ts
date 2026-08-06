import "@testing-library/jest-dom/vitest";

import { afterEach } from "vitest";

// vitest.config.ts deliberately does not set `globals: true`, which means
// @testing-library/react never gets to register its own auto-cleanup. Without
// this, rendered DOM leaks from one test into the next in any component file
// with more than one test — the second `getByText` then fails with
// "found multiple elements", or worse, silently asserts against the previous
// test's markup. Registering it here keeps every component file safe by
// default instead of relying on each one remembering.
//
// Guarded because this setup file also runs for the node-environment tests,
// which have no document and must not pull in react-dom.
if (typeof document !== "undefined") {
  const { cleanup } = await import("@testing-library/react");
  afterEach(cleanup);
}
