# document-library-tools Specification

## Purpose
The agent-facing retrieval surface over the document library: three MCP tools (`list_library`, `search_library`, `read_document`) that let the chat agent discover, search, and read library files on demand during a conversation.

## Requirements

### Requirement: The library is exposed to the agent as MCP tools

The platform SHALL expose an in-process MCP server, registered through the existing MCP configuration channel, providing exactly four tools: `list_library`, `search_library`, `read_document`, and `fetch_document_file`. Tool names SHALL follow the platform's existing MCP naming convention (`mcp__<server>__<tool>`). The tools SHALL be mounted not only in interactive chat lanes but also in agent-team execution turns and in 智语 rooms' deployed members, via the execution-side convergence point for lane tool supply (one mount, not per-path writers); mounting into a deployment member's cell SHALL pass the existing dsh tool-supply whitelist gate. If the MCP server fails to start, the lane runtime SHALL still start and the failure SHALL be logged.

#### Scenario: tools appear in the agent session

- **WHEN** a chat session starts with the library MCP server configured
- **THEN** the agent's tool roster includes the four library tools and can invoke them mid-conversation

#### Scenario: library unavailable does not break chat

- **WHEN** the library MCP server fails to initialize
- **THEN** the chat session starts and functions without library tools, and the failure is recorded in server logs

#### Scenario: fleet turn carries the library tools

- **WHEN** an agent-team execution turn starts for a member whose cell has the library server whitelisted
- **THEN** the member's tool roster includes the four library tools

#### Scenario: summoned room member carries the library tools

- **WHEN** a fleet is summoned into a 智语 room via the existing one-click bring-team flow
- **THEN** the deployed members can invoke library tools inside room turns, subject to the retrieval boundary

### Requirement: list_library enumerates the library

`list_library` SHALL return the documents in the library with id, name, type, and status, optionally filtered by collection. Collections SHALL be listed with their member document ids when no filter is given.

#### Scenario: listing the whole library

- **WHEN** the agent calls `list_library` with no arguments
- **THEN** every library document is returned with its metadata, grouped or annotated by collection where applicable

### Requirement: search_library performs lexical retrieval

`search_library` SHALL accept a query string and optional collection or document filters, and SHALL return ranked chunk hits with document name and a locator enabling follow-up reads. Results SHALL be capped at a documented maximum per call.

#### Scenario: scoped search

- **WHEN** the agent calls `search_library` with a query and a collection filter
- **THEN** only chunks of documents in that collection are searched and returned

### Requirement: read_document returns paged full text

`read_document` SHALL accept a document id and return its extracted text, paginated by a documented page size with a cursor or offset, so large documents can be read incrementally. Reading a nonexistent or non-ready document SHALL return a tool error the agent can act on.

#### Scenario: paging through a large document

- **WHEN** the agent calls `read_document` for a document longer than one page
- **THEN** the first page is returned with a cursor to the next page, and subsequent calls advance through the document in order

#### Scenario: unknown document

- **WHEN** the agent calls `read_document` with an id not in the library
- **THEN** the tool returns an error result indicating the document does not exist

### Requirement: fetch_document_file delivers original bytes to the workspace

`fetch_document_file` SHALL accept a document id and write that document's original file bytes (as uploaded, before extraction) into the agent's workspace under the original filename, returning the workspace-relative path. A document whose original bytes are not retained (e.g. URL-ingested sources, or originals aged out) SHALL return an explicit tool error naming the document; the tool SHALL NOT fall back to returning extracted text as a file.

#### Scenario: original lands in the workspace

- **WHEN** the agent calls `fetch_document_file` with the id of a docx document in the library
- **THEN** the original .docx bytes appear in the agent's workspace under the original filename
- **AND** the tool returns the workspace-relative path for further processing (edit, convert, extraction)

#### Scenario: original not retained is an explicit error

- **WHEN** the agent calls `fetch_document_file` for a document whose original bytes were never stored
- **THEN** the tool returns an error result stating the original is unavailable for that document
- **AND** no file is written to the workspace

#### Scenario: unknown document

- **WHEN** the agent calls `fetch_document_file` with an id not in the library
- **THEN** the tool returns an error result indicating the document does not exist

### Requirement: Retrieval is bounded by project, enforced server-side
Library tool results SHALL be bounded by the turn's project attribution: when a project context is active, `list_library`, `search_library`, and `read_document` SHALL cover only collections attributed to that project plus shared collections; reads outside the boundary SHALL return an act-on-able tool error and SHALL NOT leak names, counts, or content of out-of-bound documents. When no project context exists (account-level legacy sessions), the tools SHALL cover the account library as today. The boundary SHALL be enforced in the tool server, not in prompt text.

#### Scenario: fleet turn sees its project plus shared only
- **WHEN** a member attributed to project P calls `list_library`
- **THEN** only P's collections and shared collections appear, and a `read_document` for an out-of-bound id errors without confirming existence

#### Scenario: unattributed session keeps the full account library
- **WHEN** a session with no project attribution calls `search_library`
- **THEN** results span the whole account library, matching pre-boundary behavior

### Requirement: Anonymous guest lanes never receive library tools
Lanes serving anonymous or embedded-guest traffic SHALL NOT mount the library MCP server; the tool roster presented in those sessions contains no `mcp__library__*` entries.

#### Scenario: guest widget roster is library-free
- **WHEN** a visitor chats through the website embed guest widget
- **THEN** no library tool appears in the roster and any forged tool call is rejected
