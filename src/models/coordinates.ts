export interface CoordinatesProps {
    latitude: number
    longitude: number
    height?: number
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