[
  {name: "hunter-api-key", value: env.HUNTER_API_KEY},
  {name: "tavily-api-key", value: env.TAVILY_API_KEY},
  {name: "theirstack-api-key", value: env.THEIRSTACK_API_KEY}
] as $providers
| {
    properties: {
      configuration: {
        secrets: (
          [.value[] | select(.name as $name | ($providers | map(.name) | index($name)) == null)]
          + $providers
        )
      }
    }
  }
