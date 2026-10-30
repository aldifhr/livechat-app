'use client'

/**
 * The command palette: Cmd/Ctrl-K, and the same navigation the sidebar carries.
 *
 * Every destination in the console, plus the account actions, searchable by
 * name. It runs on the same `navItems` the sidebar does, so a section cannot be
 * reachable one way and missing the other.
 *
 * The palette is a convenience, not the only way through: every item here is a
 * link that also exists in the sidebar, so a browser without JavaScript still
 * has the whole console.
 */

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { KeyRound, LogOut, ScrollText } from 'lucide-react'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { navItems } from './nav'

export default function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const items = navItems()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        onOpenChange(!open)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  const go = (href: string) => {
    onOpenChange(false)
    router.push(href)
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Command menu" description="Search the console">
      <Command>
        <CommandInput placeholder="Search the console…" />
        <CommandList>
          <CommandEmpty>Nothing found.</CommandEmpty>
          <CommandGroup heading="Go to">
            {items.map((item) => {
              const Icon = item.icon
              return (
                <CommandItem key={item.href} value={`${item.label} ${item.hint}`} onSelect={() => go(item.href)}>
                  <Icon />
                  <span>{item.label}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{item.hint}</span>
                </CommandItem>
              )
            })}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Account">
            <CommandItem value="Change password" onSelect={() => go('/setting/change-password')}>
              <KeyRound />
              <span>Change password</span>
            </CommandItem>
            <CommandItem value="Backend logs" onSelect={() => go('/logs')}>
              <ScrollText />
              <span>Backend logs</span>
            </CommandItem>
            <CommandItem
              value="Sign out"
              onSelect={() => {
                onOpenChange(false)
                // A real form POST, so the logout route's redirect is followed with
                // the cleared cookie — the same reason the account menu uses one.
                const form = document.createElement('form')
                form.method = 'post'
                form.action = '/api/auth/logout'
                document.body.append(form)
                form.submit()
              }}
            >
              <LogOut />
              <span>Sign out</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
