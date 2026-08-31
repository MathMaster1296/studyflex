# studyflex

Spaced repetition for problem solving, in the browser. Every card is a
template: the numbers are drawn fresh on every review, so the method is the
only thing you can memorize.

**Live at [mathmaster1296.github.io/studyflex](https://mathmaster1296.github.io/studyflex/).**

Three years ago I made a study app called StudyFlex, and even I did not use
it. This one is built around the two reasons that happened.

## Why this exists

Regular flashcards fail at math in a specific way: after the third review of
"integrate x·e^(2x)" you are recalling the answer string, not doing
integration by parts. Here that card is a generator. Next time it comes up as
x·e^(5x), and the only way through is the method. The seed deck is
single-variable calculus: 22 generators covering derivatives, integrals,
limits, and the exact trig values everyone forgets.

The second failure is grading yourself. "Was that easy or good?" is a
negotiation, and the lazy answer compounds into a schedule built on wishful
thinking. StudyFlex checks your actual answer and grades from what happened:
wrong is again, right but slow or with a hint is hard, right and quick is
easy. You can override before moving on, but the default is measured, not
negotiated.

## How answers are checked

Typed answers are read as math, not text. 1/2, 0.5, and sqrt(2)/2 are the
same number; 12x^3, 3·4·x^3, and 12 x³ written any way you like are the same
function. Expressions are checked by sampling: both sides are evaluated at a
dozen random points, with the card's parameters bound, and have to agree
everywhere. For indefinite integrals the difference only has to be constant,
which is how "+ C" answers work without a computer algebra system. An answer
that fails to parse is an error message, not a miss.

Scheduling is FSRS-4.5 with the published default weights. The scheduler
sees one grade per card per day; a card you miss comes back a few problems
later until it sticks, and those practice reps never touch memory state. The
skills page shows the model's current recall probability per skill, weakest
first, which is the list to read the week before an exam.

## Writing cards

Cards are small JSON templates. Parameters draw from ranges (`int`, `float`),
lists (`pick`), or expressions over earlier parameters (`computed`), and
`{{a}}` slots drop them into the prompt's LaTeX. Answers are a `number`, an
`expression` with declared variables, a multiple `choice`, or `self` for
derivations you grade yourself. Saving a card draws it 100 times and makes
the reference answer pass its own checker, so a card that cannot grade
itself never reaches a session. The card editor has a live preview and the
full format reference.

Decks export and import as JSON files, and everything lives in the browser's
local storage: no server, no account, nothing leaves the page.

## Run locally

```
python3 -m http.server 8000
```

Then open http://localhost:8000. Plain HTML, CSS, and ES modules; GitHub
Pages serves the repo as-is. KaTeX is vendored so it also works offline.

## Tests

```
node test/test.mjs
```

The suite covers the expression parser (precedence, implicit multiplication,
the letter-run splitter that reads "2ax" as 2·a·x), the equivalence checker,
the FSRS schedule (grade monotonicity, lapse behavior, retention at the due
date), the session queue, and deck integrity: every shipped card is drawn
100 times and must pass its own check.

## Layout

| Path | What it is |
|---|---|
| `js/expr.js` | expression parser, evaluator, numeric equivalence |
| `js/fsrs.js` | FSRS-4.5 scheduler |
| `js/template.js` | parameter drawing, prompt filling, answer checking, validation |
| `js/session.js` | review queue, measured grading, requeue-until-it-sticks |
| `js/store.js` | localStorage persistence, streaks, export and import |
| `js/decks/calc1.js` | the calculus seed deck |
| `js/app.js` | page wiring |
| `test/test.mjs` | the whole suite, no dependencies |

## What it deliberately leaves out

There are no accounts and no sync; export is a JSON file. Sampling-based
checking can in principle be fooled by two functions that agree at a dozen
random points, which does not happen with answers a person would actually
type. Proof-style cards fall back to self-grading, because checking a
derivation is a much harder problem than checking a function.

## License

MIT
