// Strict Model Assignment sentinel: a connection tagged with this value may
// serve every model of its provider instead of a single assigned model.
//
// Kept in its own dependency-free module so both the server auth path and the
// dashboard client can import it without pulling the provider/model registries
// (tests mock `@/shared/constants/providers.js` with a partial export map).
export const MODEL_ASSIGNMENT_ALL = "*";
