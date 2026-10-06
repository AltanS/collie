import { get, route } from 'remix/routes'

export const routes = route({
  home: get('/'),
  pane: get('/pane/:id'),
})
