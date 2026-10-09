export function isNavActive(pathname: string, href: string): boolean {
  if (href === "/workspace") {
    return pathname === "/workspace" || pathname.startsWith("/workspace/");
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
