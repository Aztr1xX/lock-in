const lines = [
  "Not right now.",
  "Nice try.",
  "It'll still be there later.",
  "You're better than this tab.",
  "Stay locked in.",
  "Future you says thanks.",
];
const params = new URLSearchParams(location.search);
document.getElementById("site").textContent = params.get("site") || "This site";
document.getElementById("title").textContent = lines[Math.floor(Math.random() * lines.length)];
chrome.storage.local.get(["session"], ({ session }) => {
  if (session?.subject) document.getElementById("eyebrow").textContent = `Locked in · ${session.subject}`;
  if (session?.goal) {
    const g = document.getElementById("goal");
    g.append("Your goal: ");
    const b = document.createElement("b");
    b.textContent = session.goal;
    g.append(b);
  }
});
document.getElementById("back").onclick = () => {
  if (history.length > 2) history.go(-2);
  else window.close();
};
