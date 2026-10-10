// A person's avatar: their profile photo, or their initials in a circle when there's none
// (supply-checkout-6uw.30). Its size is fixed by its class and the img's width and height, so
// nothing moves while a photo loads, or when one that fails to load gives way to the initials.
// Where the person's name is in the text next to it, the picture is silent (alt="", and the
// initials aria-hidden); `alt` names them where it isn't (the photo on Account). `user`, the
// person's ID, lets the web build swap a photo whose link expired for a fresh one
// (src/aws/photos.js).
import { esc } from "./format.js";

// Up to two letters: the first of the first and last words of a name, or the first of an
// email address. Whole characters, so an accented or non-Latin name isn't cut in half.
export function initials(name) {
  const words = String(name ?? "").replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  const first = (w) => [...w][0];
  return words.slice(0, 1).concat(words.length > 1 ? words.slice(-1) : []).map(first).join("").toUpperCase();
}

export const avatarHTML = (url, name, size, user, alt = "") => avatarOf(url, initials(name), size, user, alt);

// The same, from the initials already worked out (an avatar being swapped keeps its own)
export function avatarOf(url, letters, size, user, alt) {
  const data = `data-user="${esc(user)}" data-initials="${esc(letters)}"`;
  return url
    ? `<img class="avatar avatar-${size}" src="${esc(url)}" alt="${esc(alt)}" width="${size}" height="${size}" ${data}>`
    : `<span class="avatar avatar-${size}" ${alt ? `role="img" aria-label="${esc(alt)}"` : `aria-hidden="true"`} ${data}>${esc(letters)}</span>`;
}
