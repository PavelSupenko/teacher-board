# Setting the board up

For teachers. No programming knowledge is needed, and nothing is installed into
the system — everything lives in one folder you can delete at any time.

You need a computer, about ten minutes, and the internet **while setting up**.
Afterwards the board works in class without any internet at all.

It works on Windows and on a Mac, both the Apple Silicon and the Intel kind, and
on Linux. The installer sees which one it is and fetches the right parts.

## 1. Get the folder

You will be handed a `class-board.zip` file, or a link to a page where the
button **Code → Download ZIP** does the same thing. Unpack the archive and put
the folder somewhere you will find it again — the Desktop is fine.

It takes about a megabyte. During setup it grows to roughly 200 MB, because the
parts the board runs on are downloaded next to it instead of into the system.

## 2. Run the installer once

**macOS.** Right-click `Install.command` and choose **Open**, then confirm.
(A plain double-click is refused the first time: macOS is cautious with files
downloaded from the internet.)

**Windows.** Double-click `Install.bat`. Windows may show a blue
“Windows protected your PC” panel — press **More info**, then **Run anyway**.
It says that about every file downloaded from the internet.

A black window appears and works for a few minutes: it downloads the parts the
board needs. No password is ever asked for. When it says **Done**, close it.

## 3. Start the board

Double-click **`Start Board`** in the same folder. The browser opens with the
board already in it, and a window with text stays behind it — do not close that
window, it is the board itself.

In that window you will find two links:

- the upper one, with `?key=…`, is **yours**: it grants full rights;
- the lower one is **for the class**.

Give the class the lower link. Everyone has to be on the same Wi-Fi. They just
open it in a browser — nothing to install on their side.

To stop the lesson, close the text window.

## 4. If pupils are at home

Start **`Start Board (share)`** instead. It does the same, and additionally
prints a pair of links beginning with `https://` that work from anywhere in the
world. Send the lower one to the class.

That address is new every time — send the fresh one before each lesson. If that
becomes tiresome, section 5 gives an address that never changes.

## 5. A permanent address (optional, done once)

This step is more technical than the rest, and it is worth asking whoever set
the computer up to do it. Afterwards nothing changes for you: the address simply
stops moving, and you can hand it out once and for all.

1. Install **Tailscale** from `tailscale.com/download` and sign in — a personal
   account is free. This creates a private network of your own devices.
2. In the admin console at `login.tailscale.com/admin/dns` turn on
   **HTTPS Certificates**.
3. Start the board as usual with `Start Board`.
4. In a terminal run `tailscale funnel 4321`. The first time it may print a link
   asking you to allow Funnel for your network — open it and confirm.
5. It prints an address of the form `https://laptop.your-network.ts.net`. That
   address stays the same forever. Pupils still need nothing installed.

Steps 1 to 4 come from Tailscale's own documentation and were not tried by the
author of the board; the rest of this page was.

## If something goes wrong

**The window closes at once, or complains.** Run the installer again: it picks
up where it left off.

**Pupils see nothing at the link.** Check that they are on the same Wi-Fi. Some
school networks isolate devices from each other; then use `Start Board (share)`.

**The board opens but the panel of tools is small.** You are in as a
participant, not as the host — open your own link, the one with `?key=…`.

**Nothing helps.** Delete the folder and start over; nothing is left behind in
the system.
