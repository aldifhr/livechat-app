'use client'

/**
 * The account menu.
 *
 * The things that are about *you* rather than about a stream: change the
 * password, read the backend log, sign out. A gear at the end of the top bar
 * opening a shadcn dropdown.
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
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'

export default function AccountMenu({ user = 'admin' }: { user?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="Account menu" className="text-muted-foreground" />
        }
      >
        <UserRound />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="flex flex-col">
          <span className="text-sm font-medium text-foreground">{user}</span>
          <span className="text-xs font-normal text-muted-foreground">Signed in</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/admin/setting/change-password" />}>
          <KeyRound />
          Change password
        </DropdownMenuItem>
        <DropdownMenuItem render={<Link href="/admin/logs" />}>
          <ScrollText />
          Backend logs
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <form action="/api/auth/logout" method="post">
          <DropdownMenuItem
            variant="destructive"
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
