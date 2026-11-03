import { describe, expect, it } from "vitest";
import {
  boardPiecesNatural,
  materialBalanceNatural,
  sanToNatural,
  systemPrompt,
  verdictPhrase,
  explainMovePrompt,
  hintPrompt,
} from "../src/coach/prompts.js";
import { contradiction, fallbackText, phrases } from "../src/coach/coaching.js";
import { reviewCacheKey, REVIEW_PROSE_VERSION } from "../src/coach/review.js";

// Ukrainian piece names decline: the mover stays in the nominative ("кінь б'є")
// while the captured piece, a promotion target and a material edge take the
// accusative ("б'є пішака", "на ферзя", "на туру більше"), and pawn counts
// pick one of three plural forms.

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("Ukrainian coach phrasing", () => {
  it("keeps the moving piece in the nominative", () => {
    expect(sanToNatural("Nf3", START, "uk", "beginner")).toBe("кінь з g1 на f3");
    expect(sanToNatural("e4", START, "uk", "beginner")).toBe("пішак на e4");
    expect(sanToNatural("Nf3", START, "uk", "kid")).toBe("коник з g1 на f3");
  });

  it("puts the captured piece in the accusative", () => {
    const fen = "rnbqkbnr/pppp1ppp/8/4p3/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 0 2";
    expect(sanToNatural("Nxe5", fen, "uk", "beginner")).toBe("кінь б'є пішака на e5");
    expect(sanToNatural("Nxe5", fen, "uk", "kid")).toBe("коник б'є пішачка на e5");
    const bishopTakes = "rnbqkbnr/pppp1ppp/8/4p3/8/2N5/PPPPPPPP/R1BQKBNR b KQkq - 1 2";
    expect(sanToNatural("Bb4", bishopTakes, "uk", "kid")).toBe("слоник з f8 на b4");
    expect(sanToNatural("Bxc3", "rnbqk1nr/pppp1ppp/8/4p3/1b6/2N5/PPPPPPPP/R1BQKBNR b KQkq - 3 3", "uk", "kid")).toBe("слоник б'є коника на c3");
  });

  it("renders castling, promotion and check", () => {
    expect(sanToNatural("O-O", "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "uk", "beginner")).toBe("коротка рокіровка");
    expect(sanToNatural("O-O-O", "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "uk", "beginner")).toBe("довга рокіровка");
    expect(sanToNatural("a8=Q+", "4k3/P7/8/8/8/8/8/4K3 w - - 0 1", "uk", "beginner"))
      .toBe("пішак на a8, перетворення на ферзя (шах)");
    expect(sanToNatural("a8=Q+", "4k3/P7/8/8/8/8/8/4K3 w - - 0 1", "uk", "kid"))
      .toBe("пішачок на a8, перетворення на королеву (шах)");
  });

  it("uses the accusative for material balance", () => {
    expect(materialBalanceNatural(0.3, "uk", "beginner")).toBe("матеріал рівний");
    expect(materialBalanceNatural(1, "uk", "beginner")).toBe("у тебе на пішака більше");
    expect(materialBalanceNatural(2, "uk", "beginner")).toBe("у тебе на 2 пішаки більше");
    expect(materialBalanceNatural(-3, "uk", "beginner")).toBe("у тебе на коня менше");
    expect(materialBalanceNatural(-5, "uk", "beginner")).toBe("у тебе на туру менше");
    expect(materialBalanceNatural(9, "uk", "kid")).toBe("у тебе на королеву більше");
  });

  it("counts pawns with the right plural form", () => {
    const eight = boardPiecesNatural(START, "white", "uk", "beginner");
    expect(eight.player).toContain("8 пішаків");
    expect(eight.player).toContain("король на e1");
    const three = boardPiecesNatural("4k3/8/8/8/8/8/PPP5/4K3 w - - 0 1", "white", "uk", "beginner");
    expect(three.player).toContain("3 пішаки");
    const one = boardPiecesNatural("4k3/8/8/8/8/8/P7/4K3 w - - 0 1", "white", "uk", "beginner");
    expect(one.player).toContain("1 пішак");
  });

  it("includes the persona and hard rules in the system prompt", () => {
    const prompt = systemPrompt("beginner", "uk");
    expect(prompt).toContain("Ти шаховий тренер Patzer");
    expect(prompt).toContain("=== ТВЕРДІ ПРАВИЛА ===");
    expect(prompt).toContain("Мова відповіді: українська");
  });

  it("has a verdict phrase for every classification", () => {
    const classes = [
      "brilliant", "great", "best", "excellent", "good", "book", "forced",
      "inaccuracy", "mistake", "blunder", "miss",
    ] as const;
    for (const c of classes) {
      expect(verdictPhrase(c, "uk"), c).toBeTruthy();
    }
  });

  it("builds explain and hint prompts in Ukrainian", () => {
    const prompt = explainMovePrompt({
      fen: START,
      player: "White",
      played_san: "e4",
      best_san: "e4",
      classification: "best",
      cp_loss: 0,
      eval_before_cp: 0,
      eval_after_cp: 1000,
      user_perspective: true,
    }, "uk", "beginner");
    expect(prompt).toContain("TASK: Розбери з гравцем цей хід як тренер");
    expect(prompt).toContain("Тільки природна мова, українською");
    expect(prompt).toContain("виграна позиція");
    expect(prompt).toContain("матеріал рівний");

    const hint = hintPrompt(START, "beginner", "uk");
    expect(hint).toContain("TASK: Допоможи гравцю як тренер перед його ходом");
    expect(hint).toContain("Тільки природна мова, українською");
  });

  it("formats fallback text in Ukrainian with 'Краще:' and proper phrases", () => {
    const p = phrases("uk");
    const t = fallbackText({
      verdict: verdictPhrase("blunder", "uk"),
      why: [p.allowsMate("ферзь б'є пішака на f7 (мат)")],
      better_move: "пішак на g6",
      takeaway: p.takeaway.allowed_mate,
    }, "uk");
    expect(t).toContain("Груба помилка");
    expect(t).toContain("Після цього ходу суперник відразу ставить мат: ферзь б'є пішака на f7 (мат).");
    expect(t).toContain("Краще: пішак на g6.");
    expect(t).toContain("Перед кожним ходом перевір усі шахи");
  });

  it("detects Ukrainian praise and blame contradictions", () => {
    expect(contradiction("Чудовий хід!", "blunder", "uk")).toBe("praise_for_mistake");
    expect(contradiction("Відмінний хід!", "mistake", "uk")).toBe("praise_for_mistake");
    expect(contradiction("Блискучий хід!", "inaccuracy", "uk")).toBe("praise_for_mistake");
    expect(contradiction("Груба помилка на рівному місці", "best", "uk")).toBe("blame_for_good_move");
    expect(contradiction("Помилка, краще було зіграти інакше", "great", "uk")).toBe("blame_for_good_move");
  });

  it("generates review cache key with Ukrainian language", () => {
    expect(reviewCacheKey({ language: "uk", audience: "intermediate" }))
      .toBe(`${REVIEW_PROSE_VERSION}|uk|intermediate`);
  });
});
