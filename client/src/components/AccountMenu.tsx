import { useRef, useState } from "react";
import { LogOut, UserRound } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuArrow,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export function AccountMenu({
  side = "bottom",
  showIdentity = false,
}: {
  side?: "bottom" | "right" | "top";
  showIdentity?: boolean;
}) {
  const { user, logout } = useAuth();
  const { toast } = useToast();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  if (!user) return null;

  const signOut = async () => {
    setSigningOut(true);
    try {
      await logout();
    } catch {
      toast({ title: "Could not log out", description: "Please try again.", variant: "destructive" });
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "h-11 w-11 shrink-0 rounded-full",
              showIdentity && "md:h-12 md:w-full md:justify-start md:gap-2.5 md:rounded-xl md:px-2",
            )}
            aria-label="Account menu"
            title="Account menu"
          >
            <Avatar className="h-9 w-9" aria-hidden>
              <AvatarFallback className="bg-primary/10 text-sm font-semibold text-primary">
                {user.username.trim().slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            {showIdentity && (
              <span className="hidden min-w-0 flex-1 truncate text-left text-sm font-semibold md:block">
                {user.username}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={side}
          align={side === "right" ? "center" : side === "top" ? "start" : "end"}
          sideOffset={10}
          collisionPadding={12}
          className="gis-account-menu z-[10020] w-40 overflow-visible rounded-xl"
          onCloseAutoFocus={(event) => {
            if (profileOpen) event.preventDefault();
          }}
        >
          <DropdownMenuArrow width={12} height={6} className="gis-account-menu-arrow" />
          <DropdownMenuItem className="cursor-pointer rounded-lg py-2" onSelect={() => setProfileOpen(true)}>
            <UserRound aria-hidden />
            Profile
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="cursor-pointer rounded-lg py-2" disabled={signingOut} onSelect={() => void signOut()}>
            <LogOut aria-hidden />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
        <DialogContent
          className="w-[calc(100%-2rem)] max-w-sm rounded-2xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Profile</DialogTitle>
            <DialogDescription>Your signed-in account</DialogDescription>
          </DialogHeader>
          <dl className="grid gap-3 rounded-xl border border-border p-4 text-sm">
            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">Username</dt>
              <dd className="min-w-0 break-words text-right font-medium">{user.username}</dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">Role</dt>
              <dd className="font-medium capitalize">{user.role}</dd>
            </div>
          </dl>
        </DialogContent>
      </Dialog>
    </>
  );
}
