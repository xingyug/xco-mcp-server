# Legal And Third-Party Notes

This file is a project-authored summary for open-source packaging. It is not an official Extreme Networks legal document and it is not legal advice.

This repository is intended to be open-sourced as an independent compatibility tool.

## What The Repository Includes

- source code for the MCP, CLI, and HTTP runtime
- tests
- a small synthetic OpenAPI fixture for offline testing

## What The Repository Does Not Include

- official Extreme Networks documentation bundles
- cached downloads from `supportdocs.extremenetworks.com`
- redistributed copies of the embedded OpenAPI specs scraped from official API reference pages
- copied Extreme Networks legal agreements or terms

That separation is intentional. The `setup` workflow downloads the requested XCO version directly from official Extreme Networks pages into the operator's local `.xco/` cache on demand.

## Non-Affiliation Statement

This project is not affiliated with, endorsed by, sponsored by, or published by Extreme Networks.

Extreme Networks names and product names are referenced only to describe interoperability and compatibility targets.

## Repository Guidance

- use `Extreme Networks` and product names only to identify compatibility
- do not imply endorsement, sponsorship, partnership, or certification
- keep a trademark attribution notice in the repository
- do not use Extreme branding assets or logos in the project identity without separate approval
- do not copy official legal text into this repository unless you have a clear right to redistribute it
- avoid persisting bastion or instance passwords in committed config files

## Documentation And Download Guidance

- do not commit downloaded `.xco/versions/*` bundles
- do not ship copied API reference HTML
- do not ship copied official spec JSON extracted from the docs site
- fetch documentation-derived specs locally during `setup`

## Operator Responsibility

Anyone running this project should review the current Extreme Networks legal terms, support terms, and product agreements applicable to their environment.

Useful official links:

- Trademark page: https://www.extremenetworks.com/about-extreme-networks/company/legal/trademarks
- Support documentation landing page: https://www.extremenetworks.com/support/documentation.asp
- XCO 3.7.0 support index: https://supportdocs.extremenetworks.com/support/documentation/extremecloud-orchestrator-3-7-0/

## Project Notice Text

Suggested attribution text for downstream redistributors:

```text
This project is not affiliated with, endorsed by, or sponsored by Extreme Networks.
Extreme Networks names, marks, and product names are used only to describe interoperability and compatibility.
Official Extreme Networks documentation and OpenAPI bundles are not redistributed with this repository.
```
