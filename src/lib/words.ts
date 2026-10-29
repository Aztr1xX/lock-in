/** A name mid-sentence: "Lemon tree" becomes "lemon tree", but "Venus flytrap" keeps its capital. */
export const lower = (name: string) => name.split(" ").map((w) => (w === "Venus" ? w : w.toLowerCase())).join(" ");

/** "a rose", "an orchid". */
export const aName = (name: string) => `${/^[aeiou]/i.test(name) ? "an" : "a"} ${lower(name)}`;
