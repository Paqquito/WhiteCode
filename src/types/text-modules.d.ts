// Supports: SPEC-MOT-003 (EF-06 texts versioned outside the code, embedded at build)
declare module "*.md" {
  const content: string;
  export default content;
}
