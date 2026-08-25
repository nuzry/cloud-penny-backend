
locals {
  # â”€â”€ Parse functions.json â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  # Each entry drives one Lambda function + zero or more API Gateway routes.
  functions_raw = jsondecode(file("${path.module}/functions.json"))

  # Keyed map for for_each iteration
  functions_map = {
    for fn in local.functions_raw : fn.name => fn
  }

  # â”€â”€ Flatten routes from all functions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  # Produces a flat list with enough context to create routes + integrations.
  all_routes = flatten([
    for fn in local.functions_raw : [
      for route in try(fn.routes, []) : {
        function_name = fn.name
        method        = route.method
        path          = route.path
        # Deterministic key: clientsme__GET__api_v1_clients_me
        # trimprefix removes the leading _ caused by paths starting with /
        key = "${fn.name}__${route.method}__${trimprefix(
          replace(replace(route.path, "/", "_"), "-", "_"),
          "_"
        )}"
      }
    ]
  ])

  # Map form for for_each
  routes_map = { for r in local.all_routes : r.key => r }

  # â”€â”€ CloudWatch log group name â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  log_group_name = "/aws/lambda/${var.project_name}"
}
