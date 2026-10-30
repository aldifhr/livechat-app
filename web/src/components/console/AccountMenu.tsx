'use client'

/**
 * The account menu.
 *
 * The things that are about *you* rather than about a stream: change the
 * password, read the backend log, sign out. It lives in the sidebar footer, at
 * the bottom of the rail, so the top bar stays a single row of chrome and the
 * account is where the eye already is when it reaches the bottom of the nav.
 *
 * Sign-out is a real `<form method="post">`, not a fetch. The logout route
 * answers with a redirect and an already-expired cookie, and a form POST is the
 * one thing that makes the browser follow that redirect *and* take the new
 * cookie with it. The dropdown row is a submit button for exactly that reason.
 */

import Link from 'next/link'
import { KeyRound, LogOut, ScrollText, UserRound } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export default function AccountMenu({
  user = 'admin',
  collapsed = false,
}: {
  user?: string
  collapsed?: boolean
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Account menu"
            className={cn(
              'flex w-full items-center gap-2.5 rounded-xl border-2 border-transparent bg-muted/60 px-2 py-2 text-left',
              'transition-colors hover:border-border hover:bg-accent-tint',
              collapsed && 'justify-center px-0',
            )}
          />
        }
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-accent-ink">
          <UserRound className="size-4" />
        </span>
        <span className={cn('flex min-w-0 flex-col', collapsed && 'hidden')}>
          <span className="truncate text-[13px] font-bold text-foreground">{user}</span>
          <span className="text-[10px] font-semibold text-muted-foreground">Signed in</span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col">
            <span className="text-sm font-medium text-foreground">{user}</span>
            <span className="text-xs font-normal text-muted-foreground">Signed in</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/setting/change-password" />}>
          <KeyRound />
          Change password
        </DropdownMenuItem>
        <DropdownMenuItem render={<Link href="/logs" />}>
          <ScrollText />
          Backend logs
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <form action="/api/auth/logout" method="post">
          <DropdownMenuItem
            variant="destructive"
            nativeButton
            render={<button type="submit" className="w-full" />}
          >
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
