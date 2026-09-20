export function StringEnum(values) {
  return { type: "string", enum: [...values] };
}
