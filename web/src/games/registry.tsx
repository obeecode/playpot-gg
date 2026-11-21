import type { ComponentType } from 'react';
import type { GameId, Mark, Move } from '../lib/types';
import { boardAt, winLine } from './tictactoe';

export interface BoardProps {
  moves: Move[];
  /** Show the position after this many moves (used by replay). */
  step: number;
  /** Cells can be clicked. */
  interactive: boolean;
  youMark: Mark;
  onMove: (cell: number) => void;
}

export interface GameModule {
  id: GameId;
  title: string;
  available: boolean;
  Board: ComponentType<BoardProps>;
}

function TicTacToeBoard({ moves, step, interactive, youMark, onMove }: BoardProps) {
  const board = boardAt(moves, step);
  const win = winLine(board);
  return (
    <div className="ttt-grid">
      {board.map((mark, i) => (
        <button
          key={i}
          className={'ttt-cell' + (win.includes(i) ? ' is-win' : '')}
          data-mark={mark ?? ''}
          disabled={!interactive || !!mark}
          aria-label={`Square ${i + 1}, ${mark ?? 'empty'}`}
          onClick={() => onMove(i)}
          data-you={mark === youMark ? 'true' : 'false'}
        >
          {mark}
        </button>
      ))}
    </div>
  );
}

const NoBoard = () => <p className="muted">This game is not playable yet.</p>;

/** Add a game here: a title and a Board component. Pages stay unchanged. */
export const GAMES: Record<GameId, GameModule> = {
  'tic-tac-toe': { id: 'tic-tac-toe', title: 'Tic-tac-toe', available: true, Board: TicTacToeBoard },
  chess: { id: 'chess', title: 'Chess', available: false, Board: NoBoard },
};
