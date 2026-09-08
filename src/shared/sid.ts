// The visitor-id contract, shared by both sides on purpose.
//
// The tracker validates what it reads back out of localStorage; the collector
// validates what arrives on a beacon. If those two shapes ever disagreed, the
// tracker would happily forward ids the collector refuses — and since a refused
// id is replaced by a throwaway one, every journey would stop chaining without
// a single error anywhere. One definition makes that drift impossible.
//
// url-safe characters only (the viewer round-trips the stored value back as a
// query parameter) and a bounded length (it lands in a TEXT column that nothing
// else truncates).
export const SID_RE = /^[\w-]{8,64}$/;

// localStorage key holding the id. Namespaced because it sits in the *host
// site's* origin, alongside whatever that site stores for itself.
export const SID_KEY = "hma_sid";
