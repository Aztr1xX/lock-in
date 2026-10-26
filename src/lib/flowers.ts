// Flowers your plant earns once it's fully grown (12 hours). Each one is a bigger milestone.

export type FlowerKind = "bloom" | "daisy" | "tulip" | "sunflower" | "rose" | "lotus" | "sakura" | "orchid" | "golden";

export interface FlowerDef {
  kind: FlowerKind;
  name: string;
  hours: number;
  line: string;
}

export const FLOWERS: FlowerDef[] = [
  { kind: "bloom", name: "First bloom", hours: 10, line: "Ten hours in. It flowered." },
  { kind: "daisy", name: "Daisy", hours: 15, line: "Fifteen hours of real focus." },
  { kind: "tulip", name: "Tulip", hours: 25, line: "Twenty-five hours. That's a habit now." },
  { kind: "sunflower", name: "Sunflower", hours: 40, line: "Forty hours. A full work week of study." },
  { kind: "rose", name: "Rose", hours: 60, line: "Sixty hours. Most people never get here." },
  { kind: "lotus", name: "Lotus", hours: 80, line: "Eighty hours of calm, steady work." },
  { kind: "sakura", name: "Cherry blossom", hours: 100, line: "One hundred hours. Legendary." },
  { kind: "orchid", name: "Orchid", hours: 150, line: "A hundred and fifty hours. Rare air." },
  { kind: "golden", name: "Golden flower", hours: 200, line: "Two hundred hours. You did the thing." },
];

export const flowersAt = (hours: number) => FLOWERS.filter((f) => hours >= f.hours);
export const nextFlower = (hours: number) => FLOWERS.find((f) => hours < f.hours) ?? null;
