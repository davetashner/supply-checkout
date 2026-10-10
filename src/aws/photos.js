// The team's profile photos (supply-checkout-6uw.30): GET /teams/{teamId}/photos lists a
// short-lived link (an hour) to the photo of each current member who has one, by user ID. The
// links are kept here, in memory only, and asked for again every PHOTOS_EVERY, before they
// expire, and when a photo fails to load (its link expired while the device slept, or the
// photo changed). Every avatar on the page (src/avatar.js, marked with its user) then gets the
// new link, or the person's initials when they have no photo any more. A link is a bearer
// link, so it's never logged or kept on the device.
import { avatarOf } from "../avatar.js";

export const PHOTOS_EVERY = 50 * 60e3;
// How long the first draw of the projects waits for the photos before it goes ahead without them
export const PHOTOS_WAIT = 2000;

// `selfId` and `selfUrl`: the signed-in user, and their photo from /me, shown until the list answers
export function createPhotos(api, teamId, selfId, selfUrl) {
  let urls = new Map(selfUrl ? [[selfId, selfUrl]] : []), loading = null;
  // Failures are kept by the photo (the link without its query string, which S3 signs anew for
  // every list): `retried` maps a photo whose link failed to that link, while the list is asked
  // for again; a photo whose fresh link fails too is `dead`, and shows as initials until its
  // photo changes (a new photo is a new path). A photo that loads is forgotten from `retried`,
  // so its link expiring again hours later is retried again.
  const retried = new Map(), dead = new Set();
  const photoOf = (link) => String(link).split("?")[0];
  const path = `/teams/${encodeURIComponent(teamId)}/photos`;

  // Asks for the list, once at a time. A list that doesn't come keeps the links there are.
  function load() {
    loading ||= api("GET", path).then(({ photos }) => {
      urls = new Map(Object.entries(photos));
      refreshAvatars();
    }, () => {}).finally(() => { loading = null; });
    return loading;
  }
  const first = load();
  // A photo's link, or null (none, or the photo doesn't load even from a fresh link)
  const current = (userId) => { const link = urls.get(userId); return link && !dead.has(photoOf(link)) ? link : null; };
  setInterval(load, PHOTOS_EVERY);

  // Puts the photo at `link` (or the initials, with none) in the avatar's place, the same size
  function swap(el, link) {
    const size = /avatar-(\d+)/.exec(el.className)[1];
    el.insertAdjacentHTML("afterend", avatarOf(link, el.dataset.initials, size, el.dataset.user, el.getAttribute("alt") || el.getAttribute("aria-label") || ""));
    el.remove();
  }
  // Every avatar on the page as it should be now
  function refreshAvatars() {
    document.querySelectorAll(".avatar[data-user]").forEach((el) => {
      const want = current(el.dataset.user);
      if (want !== el.getAttribute("src")) swap(el, want);
    });
  }

  // A photo that didn't load: ask for the list again, once per photo (another avatar with the
  // same link waits for that list), then show the new link. If a later link for the same photo
  // fails too, the photo is dead: the initials, with no more asking. A list that answers has
  // already swapped the avatar.
  document.addEventListener("error", async (e) => {
    const img = e.target;
    if (!img.matches("img.avatar[data-user]")) return;
    const src = img.getAttribute("src"), photo = photoOf(src), before = retried.get(photo);
    if (before === undefined) { retried.set(photo, src); await load(); }
    else if (before === src && loading) await loading;
    else dead.add(photo);
    if (img.isConnected) swap(img, current(img.dataset.user));
  }, true);
  document.addEventListener("load", (e) => { retried.delete(photoOf(e.target.src)); }, true);

  return {
    url: current,
    // Whether they have a photo, even one whose link failed
    has: (userId) => urls.has(userId),
    // Waits for the first list, but no longer than PHOTOS_WAIT
    ready: () => Promise.race([first, new Promise((r) => setTimeout(r, PHOTOS_WAIT))]),
    // The signed-in user's own photo changed (uploaded or removed on Account)
    set(userId, link) {
      if (link) urls.set(userId, link); else urls.delete(userId);
      refreshAvatars();
    },
  };
}
