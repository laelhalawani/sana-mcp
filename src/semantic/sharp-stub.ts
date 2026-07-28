export default function unsupportedSharp(): never {
  throw new Error("Image processing is not included in the semantic runtime.");
}
