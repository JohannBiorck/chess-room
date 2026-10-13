const destination = new URL("https://chess-room-c09w.onrender.com/");
// Assign URL components separately so a path cannot change the destination host.
destination.pathname = window.location.pathname;
destination.search = window.location.search;
destination.hash = window.location.hash;

document.getElementById("continue-link")?.setAttribute("href", destination.href);

try {
  window.location.replace(destination.href);
} catch {
  const status = document.getElementById("redirect-status");
  if (status) status.textContent = "Use the link below to continue to your game.";
}
