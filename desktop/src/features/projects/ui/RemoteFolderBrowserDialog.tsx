import * as React from "react";
import { ChevronLeft, Folder, LoaderCircle, Server } from "lucide-react";

import {
  listRemoteHostDirectory,
  type HostDirectoryListing,
  type PairedComputer,
  type ProjectFolderSelection,
} from "@/shared/api/tauriComputers";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

export function RemoteFolderBrowserDialog({
  computer,
  onOpenChange,
  onSelect,
  open,
}: {
  computer: PairedComputer | null;
  onOpenChange: (open: boolean) => void;
  onSelect: (folder: ProjectFolderSelection) => void;
  open: boolean;
}) {
  const [listing, setListing] = React.useState<HostDirectoryListing | null>(
    null,
  );
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const requestRef = React.useRef(0);

  const load = React.useCallback(
    async (path: string) => {
      if (!computer) return;
      const request = ++requestRef.current;
      setLoading(true);
      setError(null);
      try {
        const result = await listRemoteHostDirectory(
          computer.agentPubkey,
          path,
        );
        if (request === requestRef.current) setListing(result);
      } catch (cause) {
        if (request === requestRef.current) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not list this folder.",
          );
        }
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [computer],
  );

  React.useEffect(() => {
    if (!open || !computer) return;
    setListing(null);
    setError(null);
    void load(computer.defaultPath);
    return () => {
      ++requestRef.current;
    };
  }, [computer, load, open]);

  function selectCurrent() {
    if (!computer || !listing) return;
    onSelect({
      path: listing.path,
      name: listing.name,
      computerId: computer.computerId,
      computerName: computer.computerName,
      gitRepository: listing.gitRepository,
    });
    onOpenChange(false);
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-xl" data-testid="remote-folder-browser">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="h-4 w-4" />
            Choose a folder on {computer?.computerName ?? "computer"}
          </DialogTitle>
          <DialogDescription>
            Folder names and paths are encrypted between this app and the paired
            computer.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex min-h-10 items-center gap-2 rounded-xl bg-muted/40 px-2">
            <Button
              aria-label="Parent folder"
              disabled={!listing?.parent || loading}
              onClick={() => listing?.parent && void load(listing.parent)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <code className="min-w-0 flex-1 truncate text-xs">
              {listing?.path ?? computer?.defaultPath}
            </code>
          </div>

          <div className="h-72 overflow-y-auto rounded-xl border border-border/70 p-1">
            {loading && !listing ? (
              <div className="flex h-full items-center justify-center">
                <LoaderCircle className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <p className="text-sm text-destructive">{error}</p>
                <Button
                  onClick={() =>
                    void load(listing?.path ?? computer?.defaultPath ?? "")
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Try again
                </Button>
              </div>
            ) : listing?.directories.length ? (
              listing.directories.map((directory) => (
                <button
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted/60 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                  data-testid={`remote-folder-${directory.name}`}
                  key={directory.path}
                  onClick={() => void load(directory.path)}
                  type="button"
                >
                  <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{directory.name}</span>
                </button>
              ))
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                This folder has no subfolders.
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {listing?.gitRepository
                ? "Git repository"
                : "Git is not required"}
            </p>
            <Button
              data-testid="select-remote-folder"
              disabled={!listing || loading}
              onClick={selectCurrent}
              type="button"
            >
              Select this folder
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
