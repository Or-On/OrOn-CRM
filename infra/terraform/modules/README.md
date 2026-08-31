# Terraform modules

Create a module here only after at least one cohesive resource group has a stable
input/output contract. The single-VM development target does not justify a module
per resource. Expected future candidates are a small network/VM module and a
storage/identity module; Phase 1 deliberately implements neither.
