import { Cat } from "./Cat";
import { Piece, pieceNames } from "./Piece";

export function ChaosCatRules() {
  return (
    <section className="chaos-rules" aria-label="Chaos Cat rules">
      <div className="chaos-rules-heading">
        <span className="chaos-rules-cat" aria-hidden="true">
          <Cat chaos />
        </span>
        <div>
          <h3>Expect the unexpected.</h3>
          <p>The cat makes a choice after every move.</p>
        </div>
      </div>
      <div className="chaos-action-chances">
        <span>
          <strong>50%</strong> give a piece
        </span>
        <span>
          <strong>50%</strong> steal a piece
        </span>
      </div>
      <dl className="chaos-piece-chances" aria-label="Piece selection probabilities">
        {(["p", "r", "b", "n", "q"] as const).map((piece) => (
          <div key={piece}>
            <dt>
              <Piece type={piece} color="black" />
              <span>{pieceNames[piece]}</span>
            </dt>
            <dd>{piece === "p" ? "50%" : "12.5%"}</dd>
          </div>
        ))}
      </dl>
      <p className="chaos-target-note">
        Gifts land on an empty square in your half. Steals pick one of your pieces of the chosen
        type. No matching piece or available square means no change. Kings are never given or
        stolen.
      </p>
      <p className="chaos-king-warning">
        Watch your king: the cat can leave it exposed. Your opponent can capture it to win.
      </p>
    </section>
  );
}
