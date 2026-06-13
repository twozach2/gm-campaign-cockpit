export async function openTicketedEventSource({
  issueTicket,
  buildUrl,
  createEventSource = (url) => new EventSource(url),
}) {
  const { ticket } = await issueTicket();
  if (!ticket) throw new Error("The server did not issue a stream ticket");
  return createEventSource(buildUrl(ticket));
}
