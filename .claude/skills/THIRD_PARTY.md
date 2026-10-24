# Third-party skills

The `hyperframes`, `hyperframes-cli`, `hyperframes-registry` and `media-use` skills come from
[heygen-com/hyperframes](https://github.com/heygen-com/hyperframes), copyright HeyGen, Inc.,
licensed under the Apache License 2.0 (see `LICENSE-hyperframes.txt`). They are unmodified copies,
installed with:

    npx skills add heygen-com/hyperframes --full-depth --agent claude-code \
      --skill hyperframes hyperframes-cli hyperframes-registry media-use --copy

`skills-lock.json` in the repository root pins their content hashes. Update them with `npx skills update`
and review the diff before committing: skills run with the agent's permissions.
