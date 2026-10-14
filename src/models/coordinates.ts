export interface CoordinatesProps {
    latitude: number
    longitude: number
    height?: number
}

/** Great-circle distance in km between two positions (haversine). */
export function haversineKm(a: CoordinatesProps, b: CoordinatesProps): number {
    const R = 6371
    const dLat = (b.latitude - a.latitude) * Math.PI / 180
    const dLon = (b.longitude - a.longitude) * Math.PI / 180
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * Math.PI / 180) * Math.cos(b.latitude * Math.PI / 180) * Math.sin(dLon / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(s))
}

export class Coordinates {
    public latitude: number
    public longitude: number
    public height?: number

    constructor(props: CoordinatesProps) {
        this.latitude = props.latitude
        this.longitude = props.longitude
        this.height = props?.height
    }
}