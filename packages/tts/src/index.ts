/**
 * @exxeed/tts — turning a note set's words into measured audio. §10 stage 6.
 *
 * ## Why this is not in services/ingest
 *
 * §10 is emphatic that the ingest pipeline is a standalone offline CLI, never
 * bundled into the app — and the reason is stages 0 to 5: "Never call an LLM from
 * the client", and §8.1's service-role key that must never ship in an Electron
 * bundle, which is a zip file anyone can open.
 *
 * Stage 6 is none of that. It runs a local binary, makes no network call, holds
 * no credential, and it already serves two masters: the ingest pipeline renders
 * what the model produced, and the note editor renders what a person just typed.
 * Leaving it in `services/ingest` would mean the app depending on the package
 * that will eventually hold the API keys, which is the one thing §10 is guarding
 * against.
 *
 * So the boundary stays exactly where §10 wants it. It just runs through the
 * middle of §10's own stage list rather than around the outside of it.
 */

export * from "./engine.js";
export * from "./render.js";
