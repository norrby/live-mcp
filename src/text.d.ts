// The bridge's Python files are bundled as text (build.mts loads .py with esbuild's text loader).
declare module "*.py" {
  const text: string;
  export default text;
}
