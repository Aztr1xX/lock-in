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
