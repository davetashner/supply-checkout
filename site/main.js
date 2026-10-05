// The clips play muted and loop, and only while on screen (without this script, or for anyone
// who prefers reduced motion, the poster shows). With reduced motion there's a button to play
// and pause each clip. A clip is described by the figure's hidden caption.
const clips = [...document.querySelectorAll(".screen video")];
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

if (still) {
  for (const video of clips) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "play";
    const show = () => {
      const playing = !video.paused;
      button.setAttribute("aria-label", `${playing ? "Pause" : "Play"} the clip: ${video.closest("figure").querySelector("figcaption").textContent}`);
      button.dataset.state = playing ? "playing" : "paused";
    };
    button.addEventListener("click", () => (video.paused ? video.play().catch(() => {}) : video.pause()));
    video.addEventListener("play", show);
    video.addEventListener("pause", show);
    show();
    video.after(button);
  }
} else if ("IntersectionObserver" in window) {
  // Playing starts once the page has loaded and settled, so the clips never compete with it
  // (the posters are what loads first, and what a measure of the page's load sees)
  const watch = () => {
    const seen = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) e.target.play().catch(() => {});
        else e.target.pause();
      }
    }, { threshold: 0.4 });
    for (const video of clips) seen.observe(video);
  };
  const later = () => setTimeout(watch, 1500);
  if (document.readyState === "complete") later();
  else addEventListener("load", later, { once: true });
}
