# Backlog

## OnBoarding 
The onboarding flow should open in the Assistant view the first time the plugin is used, starting with a clean welcome screen that uses a large origami icon, the title “Welcome”, the phrase “Turn your notes into a conversation...”, and a “Let’s start” button. After that, setup should be presented as three vertical steps on a single page: Ollama Host with the default `http://localhost:11434`, Ollama Chat Model with the default `gemma4`, and Ollama Embeddings Model with the default `nomic-embed-text`; completed steps should be clickable so users can go back and edit them. The host step should validate the server with `ollama.version()`, model dropdowns should be populated with `ollama.list()` and preselect `gemma4:latest` or `nomic-embed-text:latest` when available, and any connection or missing-model problems should appear in the same step as a light-blue hint container with a lightbulb icon and actionable guidance such as installing/running Ollama or downloading a model with `ollama run gemma4`.

## Assistant
