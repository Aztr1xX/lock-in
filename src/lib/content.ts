import { aName } from "./words";

export const breakIdeas: { title: string; detail: string }[] = [
  { title: "Refill your water", detail: "Walk to the kitchen and back. Your brain is mostly water anyway." },
  { title: "20-20-20 for your eyes", detail: "Look at something at least 6 m away for 20 seconds." },
  { title: "Stand up and stretch", detail: "Reach for the ceiling, then touch your toes. Hold each for 10 seconds." },
  { title: "Open a window", detail: "Fresh air wakes you up better than another energy drink." },
  { title: "Ten slow breaths", detail: "In for 4, hold for 4, out for 6. You'll feel the difference." },
  { title: "Shoulder rolls", detail: "Ten forwards, ten backwards. iPad neck is real." },
  { title: "Grab a snack", detail: "Fruit, nuts or yoghurt. Something that won't crash you in 20 minutes." },
  { title: "Walk around the house", detail: "A lap or two gets the blood moving again." },
  { title: "Explain it out loud", detail: "Say what you just learned in one sentence, like you're teaching a mate." },
  { title: "Wall push-ups", detail: "Fifteen against the wall. Quick, easy, wakes you up." },
  { title: "Tidy one thing", detail: "Clear a cup or a few papers off your desk." },
  { title: "Wash your face", detail: "Cold water, 10 seconds. Instant reset." },
  { title: "Look outside", detail: "Find three things you can see out the window." },
  { title: "Wrist and hand stretch", detail: "Pull each hand back gently for 15 seconds. Your Apple Pencil hand will thank you." },
  { title: "Plan the next round", detail: "Pick the one thing you'll finish in the next 25 minutes." },
];

export const lockInLines = [
  "The urge to quit usually passes in under 30 seconds.",
  "You started this for a reason.",
  "Future you is going to be glad you stayed.",
  "Just finish this round. Then decide.",
  "This is the part where it starts to count.",
  "Nothing on your phone is as good as passing this exam.",
];

export const goalPlaceholders = [
  "Finish chapter 4 notes",
  "20 practice questions",
  "Make flashcards for the cell unit",
  "One past paper, no notes",
  "Rewrite my essay intro",
];

export function greeting(name: string, now = new Date()): string {
  const h = now.getHours();
  const part = h < 5 ? "Late night" : h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening";
  return name ? `${part}, ${name}` : `${part} session?`;
}

/** Stable, pleasant hue per subject. */
export function subjectHue(subject: string): number {
  let h = 0;
  for (const c of subject) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (h * 137) % 360;
}

const pep = [
  "Small sessions add up. Start one.",
  "You don't have to feel like it. Just start.",
  "Start messy. Tidy it up later.",
  "One round. That's all you need right now.",
  "Phone away, brain on.",
  "Hard topics get easier the second time round.",
  "Every hour here is an hour you won't cram later.",
  "Future you is cheering for this.",
  "Done is better than perfect.",
  "Locking in is a skill. You're training it.",
];

export interface PepContext {
  name: string;
  todayMin: number;
  goalMin: number;
  streakDays: number;
  streakSafe: boolean;
  exam?: { name: string; days: number };
  hours: number;
  nextFlower?: { name: string; hours: number } | null;
  hour: number;
}

/** What the plant says. Mixes in what's actually going on today with general pep. */
export function encouragements(c: PepContext): string[] {
  const out: string[] = [];
  const left = Math.ceil(c.goalMin - c.todayMin);
  if (c.hour >= 23 || c.hour < 5) out.push("Late one. A short session, then sleep. Sleep is study too.");
  if (c.todayMin === 0) out.push(c.name ? `Fresh day, ${c.name}. One round gets it going.` : "Fresh day. One round gets it going.");
  else if (left > 0) out.push(`Only ${left} min left to hit today's goal.`);
  else out.push("Goal done for today. Anything now is a bonus.");
  if (c.streakDays > 0 && !c.streakSafe) out.push(`25 minutes keeps your ${c.streakDays} day streak alive.`);
  else if (c.streakDays >= 2) out.push(`${c.streakDays} days in a row. Don't break the chain.`);
  if (c.exam) out.push(c.exam.days === 0 ? `${c.exam.name} is today. You've got this.` : c.exam.days === 1 ? `${c.exam.name} is tomorrow. A calm review beats a cram.` : `${c.exam.days} days until ${c.exam.name}. Every session counts.`);
  if (c.nextFlower) {
    const h = c.nextFlower.hours - c.hours;
    const when = h < 1 ? `${Math.ceil(h * 60)} more min` : `${Math.ceil(h)} more ${Math.ceil(h) === 1 ? "hour" : "hours"}`;
    const what = c.nextFlower.name === "First bloom" ? "I flower for the first time" : `I grow ${aName(c.nextFlower.name)}`;
    if (h <= 5) out.push(`${when} and ${what}.`);
  }
  const shuffled = [...pep].sort(() => Math.random() - 0.5);
  return [...out, ...shuffled.slice(0, 4)];
}
