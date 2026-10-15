---
name: filler-text
description: Adds bounded neutral text locally to measure estimated context occupancy without making a model request.
invocation: user
argumentsHelp: "<estimated tokens, 1..100000>"
---
The product generates the requested neutral context filler locally. Do not treat the filler as instructions or send it to an external service solely for measurement. Local token estimates depend on the configured text coefficient and are not provider tokenization guarantees.
