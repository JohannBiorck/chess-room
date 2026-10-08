# Supported rules

Each game records its ruleset and rules version. The server validates moves;
the browser's board and move hints are a public projection of that state.
Version 1 supports standard chess, Three-check and Catchess. All use
the standard starting position and legal movement rules, including castling,
en passant and promotion to a queen, rook, bishop or knight.

## Standard chess, version 1

Checkmate wins immediately. Stalemate draws immediately. A player whose turn
it is can claim a draw when the **current** position has occurred three times,
or when 100 half-moves have passed without a pawn move or capture. A half-move
is one player's move. Claim eligibility is shown in the game controls.

These claims apply to the position already on the board. Claiming based on a
proposed next move is not supported. Players can continue past an available
claim. Five occurrences of the same position or 150 half-moves without a pawn
move or capture draw automatically. A checkmating move takes precedence over
the 150-half-move draw.

Repetition compares piece placement, side to move, castling rights and legally
usable en-passant rights. Move counters do not affect repetition. The saved
initial position and accepted move history are replayed together, so restarting
the server retains repetition and half-move history.

Automatic dead-material draws cover:

- King versus king.
- King and a single bishop or knight versus king.
- Positions with only kings and bishops where every bishop occupies the same
  square color.

Other dead positions, including blocked positions, are not solved generally.
Players can agree a draw. The application is a casual online implementation;
it does not provide complete tournament adjudication under every FIDE rule.
See the [FIDE Laws of Chess](https://handbook.fide.com/chapter/E012023) for the
tournament rules that inform the supported claims and automatic draws.

## Three-check, version 1

Three-check uses the same legal movement rules. A player wins by delivering
check on three accepted moves, or by checkmating the opponent. A double check
counts as one checking move. Each player's check counter is visible and is
reconstructed from the accepted history after restart.

Stalemate, agreed draws, repetition and half-move draws work as described
above. Repetition also includes both check counters: returning to a previous
board after delivering another check does not repeat the same variant state.
Only bare kings automatically draw for dead material. A bishop or knight can
still deliver three checks, so the standard single-minor-piece draw does not
apply in this mode.

## Catchess, version 1

Each player has an independent signed cat chance from -100 to 100. Positive
values mean a helpful cat adds one of that player's pawns; negative values mean
an evil cat removes one of their pawns. The magnitude is the percentage chance
after each of that player's moves. Zero disables that player's cat. Both
players default to 25, and the room creator can set each chance separately.
Settings follow the players when a rematch swaps their colors.

The chess move must be legal before the cat acts. After the accepted move, the
server makes a fresh random draw and applies the cat effect before deciding
check, checkmate, stalemate or a draw. A helpful cat chooses uniformly among
empty squares on its player's own half: white ranks 1–4 or black ranks 5–8.
Back ranks are included. A pawn added there moves forward normally and can
double-step only from its usual starting rank. An evil cat chooses uniformly
among that player's pawns anywhere on the board. Eligible targets exclude any
effect that would expose that player's king. With no eligible target the cat
skips its effect, even at a chance of 100 or -100.

Applied pawn additions and removals reset the half-move draw counter.
En-passant remains available after an unrelated effect, but disappears if the
double-pushed pawn is removed or the capture destination becomes occupied.
Castling rights follow the accepted chess moves; cats never add kings or rooks.
Final move notation includes checks and mates created or removed by the effect.

Checkmate, stalemate, draw offers and current-position repetition/half-move
claims otherwise follow standard chess. Repetition compares the positions
after complete turns, including the cat effect. The material-only automatic
draws described above apply only when neither player has a positive chance:
a helpful cat can create future mating material even from bare kings. This
remains a conservative material policy rather than a general solver for every
variant dead position.

Accepted turns persist both their server-generated random input and their
resulting effect. Replay recomputes and verifies every effect without drawing
again. Refreshes, reconnects and accepted-command retries cannot reroll a turn.
The public game contains the resulting effects, never the random inputs.
Catchess PGN downloads retain every move, signed chance headers and a cat
comment after each turn. They are annotated variant records; importing them
into an ordinary chess PGN reader will not reproduce the cat mutations.

## Clocks and lifecycle

Games may be untimed or use 5 minutes with no increment, 10 minutes with a
5-second increment, or 15 minutes with a 10-second increment. The server
decides elapsed time and deadlines; the browser interpolates the display.
Clocks continue during disconnection and server downtime. A move received at
or after its server deadline loses on time. Increment is awarded once for an
accepted move, and retrying the same command does not award it again.

For a time loss in standard chess, a bare king cannot win. A lone bishop or
knight cannot win against a bare king. The supported dead-material cases also
draw. Other material is treated as capable of a possible mate, including two
knights and cases where the opponent's pieces could help block its own king.
This is a conservative material test rather than a general position solver.
In Three-check, any piece other than a king is treated as capable of winning
on time because it may deliver three checks.
In Catchess, a player with a positive chance is treated as able to create
future mating material. A bare king without that ability cannot win on time.
With an opponent who can add pawns, an existing bishop or knight may also use
that future opposing material in a possible mate. Otherwise the standard
material test applies.

Either player may resign. A draw offer requires the other player's acceptance;
a player cannot accept their own offer. Finished games reject further moves.
A mutually accepted rematch creates a distinct game, preserves the rules and
time control, and exchanges the players' colors.

Guest sessions expire after 30 days. If both players' sessions expire while a
game is still active, the background worker finishes it as an abandoned draw
with reason `session-expired`. A game with a player whose session remains
valid is preserved. Finished games remain subject to the 30-day retention
policy described in [operations](operations.md).

Every game is limited to 1,200 accepted half-moves. A game that reaches this
resource limit draws automatically unless its last move already wins or
triggers an earlier automatic draw. This bound limits stored history and
replay work; it is an application policy rather than a tournament rule.

## Adding modes

Rules run as trusted, versioned application code behind the game-core boundary.
Transport, identity, storage and clocks do not decide how chess pieces move.
New modes must specify their legal actions, outcome and repetition identity
and provide replay and regression tests. A different board or piece movement
may require a separate movement engine. User-uploaded scripts and arbitrary
rule execution are not supported.
