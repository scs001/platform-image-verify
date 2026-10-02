## ADDED Requirements

### Requirement: A pending bot ask renders as numbered-option text

WHEN an ask is pending in a bot chat, the bot SHALL deliver the question batch to the chat as text: each question with its options numbered, guidance to reply with a number or an option's exact wording, and — for multi-select questions — a note that several numbers may be replied comma-separated. A question with no options SHALL be asked as a plain free-text question whose next reply becomes the custom answer.

#### Scenario: options question renders with numbers

- **WHEN** an ask with options becomes pending in a bot chat
- **THEN** the chat receives the question as text with numbered options and reply guidance

#### Scenario: free-text question asks plainly

- **WHEN** an ask with no options becomes pending in a bot chat
- **THEN** the chat receives the question as text and the next reply is treated as the custom answer

### Requirement: The next inbound message answers the pending ask instead of starting a turn

WHILE an ask is pending in a bot chat, the next inbound message SHALL be intercepted as an answer attempt and SHALL NOT queue a new agent turn. A reply matching a number or an option's exact wording SHALL select that option; a multi-select reply of several numbers SHALL select each; any other text SHALL be submitted as the custom answer for free-text-accepting questions, otherwise the bot SHALL re-prompt with the options again — after three failed attempts the ask SHALL be cancelled automatically. Existing inbound guards (size, rate) apply unchanged before interception.

#### Scenario: a number selects its option

- **WHEN** the user replies "2" to a pending numbered question
- **THEN** the second option is submitted as the answer and no new turn starts

#### Scenario: plain text becomes a custom answer

- **WHEN** the user replies free text to a question accepting custom answers
- **THEN** the text is submitted as the custom answer

#### Scenario: three failed attempts cancel the ask

- **WHEN** three consecutive replies match no option of a question that accepts no custom answer
- **THEN** the ask is cancelled automatically and the model continues with a cancelled result

### Requirement: The ask wait window bounds waiting and pauses the turn timeout

A bot ask SHALL wait at most a configurable window (default 10 minutes) for the user's reply; while the ask is pending, the turn hard timeout SHALL be paused, and on window expiry the ask SHALL be cancelled automatically with the turn continuing to its normal conclusion.

#### Scenario: window expiry cancels the ask

- **WHEN** the wait window elapses with no reply
- **THEN** the ask is cancelled, the model receives a cancelled result, and the turn concludes normally

#### Scenario: turn timeout does not fire while waiting

- **WHEN** an ask has been pending longer than the turn hard timeout
- **THEN** the turn is not failed while the ask is pending

### Requirement: The answer-only posture exempts the ask tool

UNDER the default no-tools posture, `ask_user_question` SHALL remain callable in bot sessions, and a turn whose reply incorporates the user's answer to an ask SHALL NOT be withheld as tool-derived.

#### Scenario: an ask works under the default posture

- **WHEN** the agent asks and the user answers under the default no-tools posture
- **THEN** the ask is delivered, the answer resolves it, and the final reply is delivered to the chat
