declare module "*.wasm" {
  const embeddedFilePath: string;
  export default embeddedFilePath;
}
