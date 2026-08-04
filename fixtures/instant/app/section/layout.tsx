// A layout-declared `prefetch` governs every page beneath it, so reading only the
// page would miss it entirely. crust records it against the nested route prefixed
// with the layout that set it, which is what lets the diff blame the layout rather
// than the page that inherited it.
export const prefetch = 'force-disabled'

export default function SectionLayout({ children }: { children: React.ReactNode }) {
  return <section>{children}</section>
}
