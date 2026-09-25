$id-7316842059743168
title: Skrynia is Antonina's only backend
date: 2026/09/25
source: @ottojung
kind: constraint

Antonina has no application server or trusted Antonina backend between its clients and storage. The web UI and CLI are the two client front ends and talk directly to Skrynia. Skrynia remains a simple generic database/storage service; Antonina must not depend on adding Antonina-specific authorization, permission, delegation, business-logic, or workflow enforcement to Skrynia.
