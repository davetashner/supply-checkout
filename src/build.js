// Which build this is, fixed when Vite builds it (vite --mode artifact, web or demo; the dev
// server is "development"). Code that only another build can reach goes behind `WEB`, so the
// artifact build drops it: `WEB && db.command` compiles to `false` there, and the web-only
// side isn't in the artifact at all. That keeps it out of the artifact's coverage count too,
// since coverage is measured on what each build ships (docs/testing.md).
export const WEB = import.meta.env.MODE !== "artifact";
